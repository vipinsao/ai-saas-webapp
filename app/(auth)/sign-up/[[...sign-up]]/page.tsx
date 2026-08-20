import { SignUp } from "@clerk/nextjs";

/**
 * Deliberately the same frame as /sign-in.
 *
 * This page used to be `return <SignUp />` and nothing else, so following the
 * "Sign up" link from the styled sign-in card dropped the visitor onto a bare
 * component pinned to the top-left corner of a white page -- two clicks from
 * the front door.
 */
export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl p-6 sm:p-8 flex flex-col items-center">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-gray-800">
            Welcome To SocialShare!
          </h1>
          <p className="text-gray-500">Create an account to get started 🚀</p>
        </div>
        <div className="w-full">
          <SignUp
            path="/sign-up"
            routing="path"
            signInUrl="/sign-in"
            appearance={{
              elements: {
                card: "shadow-none border-none",
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
